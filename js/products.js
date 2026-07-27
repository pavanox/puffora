let interval;

function initSlider(category){

    let slides=category.querySelectorAll(".slide");
    let dotsContainer=category.querySelector(".dots");
    let prev=category.querySelector(".prev");
    let next=category.querySelector(".next");

    dotsContainer.innerHTML="";

    let current=0;

    slides.forEach((s,i)=>{

        let dot=document.createElement("span");
        dot.className="dot";

        if(i==0) dot.classList.add("active");

        dot.onclick=()=>{

            current=i;
            show();

        };

        dotsContainer.appendChild(dot);

    });

    let dots=dotsContainer.querySelectorAll(".dot");

    function show(){

        slides.forEach(sl=>sl.classList.remove("active"));
        dots.forEach(d=>d.classList.remove("active"));

        slides[current].classList.add("active");
        dots[current].classList.add("active");

    }

    function nextSlide(){

        current++;

        if(current>=slides.length)
            current=0;

        show();

    }

    function prevSlide(){

        current--;

        if(current<0)
            current=slides.length-1;

        show();

    }

    next.onclick=()=>{

        nextSlide();
        restart();

    }

    prev.onclick=()=>{

        prevSlide();
        restart();

    }

    function restart(){

        clearInterval(interval);

        interval=setInterval(nextSlide,3000);

    }

    restart();

}

document.querySelectorAll(".category").forEach(initSlider);

function changeCategory(id,btn){

    document.querySelectorAll(".category").forEach(c=>c.classList.remove("active"));

    document.getElementById(id).classList.add("active");

    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));

    btn.classList.add("active");

}